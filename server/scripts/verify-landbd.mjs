/**
 * Smoke: Land acquisition + Business development server surface.
 *
 * Covers the field parity the pages need (every column the SPA model carries
 * must survive a round trip), the funnel transitions, document versioning and
 * the verifier stamp, the BD → Land hand-off link, and tenant isolation.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'admin@erptest.local']);

const MARK = 'LBD Smoke';
async function cleanup() {
  await admin.query(`DELETE FROM feasibility_records WHERE land_lead_id IN (SELECT id FROM land_leads WHERE owner_name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM land_documents WHERE land_lead_id IN (SELECT id FROM land_leads WHERE owner_name LIKE '${MARK}%')`);
  await admin.query(`UPDATE bd_leads SET land_lead_id = NULL WHERE counterparty_name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM land_leads WHERE owner_name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM bd_leads WHERE counterparty_name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM market_reports WHERE area_name LIKE '${MARK}%'`);
}
await cleanup();

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@erptest.local', password: PW }),
})).json()).token;
if (!tok) { console.error('login failed'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const patch = async (p, b) => { const r = await fetch(BASE + p, { method: 'PATCH', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = async (p) => (await (await fetch(BASE + p, { headers: H })).json());

// ── Land parcel: full field parity ──────────────────────────────────────────
console.log('\n=== LAND PARCEL FIELD PARITY ===');
const draft = {
  referenceSource: 'broker', ownerName: `${MARK} Ramesh Patel`, ownerContact: '9876543210',
  location: 'Off Sarjapur Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560035',
  surveyNumber: 'SY-114/2B', areaAcres: 4.5, askingPrice: 82000000,
  ownershipType: 'freehold', zoning: 'Residential R1',
  fsiPermissible: 2.75, fsiConsumed: 0.4, roadWidthFt: 60,
  isEncumbered: false, encumbranceNotes: 'clean title, EC verified',
  litigationStatus: 'none',
};
const landRes = await post('/api/land-leads', draft);
const land = landRes.body?.landLead;
ok('parcel created (201)', landRes.status === 201 && !!land?.id, `${landRes.status} ${JSON.stringify(landRes.body)?.slice(0, 140)}`);

const parityMisses = Object.entries(draft).filter(([k, v]) => {
  const got = land?.[k];
  return typeof v === 'number' ? Number(got) !== v : got !== v;
}).map(([k, v]) => `${k}: sent ${JSON.stringify(v)} got ${JSON.stringify(land?.[k])}`);
ok('every submitted field round-trips', parityMisses.length === 0, parityMisses.join(' | '));
ok('createdBy + createdAt stamped', !!land?.createdBy && !!land?.createdAt);
// The default must be a value the SPA's LandLeadStatus union contains — its
// status lookup used to assert non-null and crashed the page on anything else.
ok('default status is in the client vocabulary', land?.status === 'lead_reference', String(land?.status));
const badStatus = await post('/api/land-leads', { ownerName: `${MARK} Bad`, surveyNumber: 'SY-BAD', status: 'sourced' });
ok('out-of-vocabulary status rejected (400)', badStatus.status === 400, `${badStatus.status} ${JSON.stringify(badStatus.body)?.slice(0, 100)}`);
ok('parcel visible immediately', ((await get('/api/land-leads')).landLeads || []).some(l => l.id === land?.id));

// ── Feasibility ─────────────────────────────────────────────────────────────
console.log('\n=== FEASIBILITY ===');
const feasRes = await post('/api/feasibility', {
  landLeadId: land.id, costPerSqft: 7800, saleableArea: 145000,
  estimatedRevenue: 1131000000, marginPercent: 24.6, score: 72, cappedByRisk: false,
});
const feas = feasRes.body?.feasibility;
ok('feasibility created (201)', feasRes.status === 201 && !!feas?.id, `${feasRes.status}`);
ok('create response carries full record', feas?.costPerSqft === 7800 && feas?.saleableArea === 145000 && !!feas?.computedAt,
  JSON.stringify(feas)?.slice(0, 160));
const afterFeas = ((await get('/api/land-leads')).landLeads || []).find(l => l.id === land.id);
ok('latest_score bumped on the parcel', Number(afterFeas?.latestScore) === 72, String(afterFeas?.latestScore));

// ── Documents: versioning + verifier stamp ──────────────────────────────────
console.log('\n=== LAND DOCUMENTS ===');
const d1 = (await post('/api/land-documents', { landLeadId: land.id, docType: 'title_deed', fileName: 'deed-v1.pdf', version: 1 })).body?.document;
const d2 = (await post('/api/land-documents', { landLeadId: land.id, docType: 'title_deed', fileName: 'deed-v2.pdf', version: 2 })).body?.document;
ok('two versions coexist (never overwritten)', !!d1?.id && !!d2?.id && d1.id !== d2.id);
ok('create response carries uploadedBy + createdAt', !!d2?.uploadedBy && !!d2?.createdAt, JSON.stringify(d2)?.slice(0, 140));
const verRes = await patch(`/api/land-documents/${d2.id}`, { verificationStatus: 'verified' });
ok('verify stamps verifiedBy + verifiedAt', verRes.status === 200 && !!verRes.body?.document?.verifiedBy && !!verRes.body?.document?.verifiedAt, `${verRes.status}`);
const rejRes = await patch(`/api/land-documents/${d1.id}`, { verificationStatus: 'pending' });
ok('reverting to pending clears the stamp', rejRes.body?.document?.verifiedAt === null, String(rejRes.body?.document?.verifiedAt));

// ── Funnel transitions ──────────────────────────────────────────────────────
console.log('\n=== LAND FUNNEL ===');
const q = await patch(`/api/land-leads/${land.id}`, { status: 'qualified' });
ok('qualify transition', q.status === 200 && q.body?.landLead?.status === 'qualified', `${q.status}`);
const rej = await patch(`/api/land-leads/${land.id}`, { status: 'rejected', rejectionReason: 'Owner withdrew' });
ok('reject carries the reason', rej.body?.landLead?.status === 'rejected' && rej.body?.landLead?.rejectionReason === 'Owner withdrew');

// ── BD: field parity + hand-off ─────────────────────────────────────────────
console.log('\n=== BD OPPORTUNITY ===');
const bdDraft = {
  opportunityType: 'jv', source: 'broker', counterpartyName: `${MARK} Sunrise Estates`,
  counterpartyContact: '9123456780', city: 'Pune', estimatedDealValue: 250000000,
  jvStructure: 'revenue_share', revenueSharePercent: 42.5, areaSharePercent: 35,
  jvNotes: 'Landowner wants a floor-rise share too',
};
const bdRes = await post('/api/bd-leads', bdDraft);
const bd = bdRes.body?.bdLead;
ok('BD deal created (201)', bdRes.status === 201 && !!bd?.id, `${bdRes.status}`);
const bdMisses = Object.entries(bdDraft).filter(([k, v]) => {
  const got = bd?.[k];
  return typeof v === 'number' ? Number(got) !== v : got !== v;
}).map(([k, v]) => `${k}: sent ${JSON.stringify(v)} got ${JSON.stringify(bd?.[k])}`);
ok('every BD field round-trips (incl. jvNotes)', bdMisses.length === 0, bdMisses.join(' | '));
ok('default stage is in the client vocabulary', bd?.stage === 'identified', String(bd?.stage));
{ const badStage = await post('/api/bd-leads', { counterpartyName: `${MARK} Bad`, stage: 'prospecting' });
  ok('out-of-vocabulary stage rejected (400)', badStage.status === 400, `${badStage.status}`); }

// Hand-off: create the parcel, then link it to the deal.
const parcel = (await post('/api/land-leads', {
  ownerName: `${MARK} Sunrise Estates`, ownerContact: '9123456780', city: 'Pune',
  surveyNumber: `BD-${bd.id.slice(0, 6).toUpperCase()}`, askingPrice: 250000000, referenceSource: 'broker',
})).body?.landLead;
const link = await patch(`/api/bd-leads/${bd.id}`, { stage: 'handed_to_land', landLeadId: parcel.id });
ok('hand-off links deal → parcel', link.status === 200 && link.body?.bdLead?.landLeadId === parcel.id, `${link.status}`);
ok('hand-off advances the stage', link.body?.bdLead?.stage === 'handed_to_land');
const lost = await patch(`/api/bd-leads/${bd.id}`, { stage: 'closed_lost', closedLostReason: 'Counterparty went silent' });
ok('closed-lost keeps the reason (never deleted)', lost.body?.bdLead?.closedLostReason === 'Counterparty went silent');

// ── Market reports ──────────────────────────────────────────────────────────
console.log('\n=== MARKET REPORTS ===');
const repRes = await post('/api/market-reports', {
  areaName: `${MARK} Wakad`, reportType: 'pricing_benchmark',
  findings: 'Ready-reckoner up 8% YoY; 2BHK absorption 14 units/month.',
  dataSources: 'Registrar data, 4 broker channels',
});
const rep = repRes.body?.report;
ok('report created (201)', repRes.status === 201 && !!rep?.id, `${repRes.status}`);
ok('create response carries dataSources + createdBy', rep?.dataSources === 'Registrar data, 4 broker channels' && !!rep?.createdBy,
  JSON.stringify(rep)?.slice(0, 140));
ok('report visible immediately', ((await get('/api/market-reports')).reports || []).some(r => r.id === rep?.id));

// ── tenant isolation ────────────────────────────────────────────────────────
console.log('\n=== TENANT ISOLATION ===');
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'badmin@rival.test']);
const rivalTok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'badmin@rival.test', password: PW }),
})).json()).token;
if (rivalTok) {
  const RH = { Authorization: `Bearer ${rivalTok}` };
  const rl = (await (await fetch(`${BASE}/api/land-leads`, { headers: RH })).json()).landLeads || [];
  ok('rival sees 0 of our parcels', !rl.some(l => l.id === land.id), `saw ${rl.length}`);
  const rb = (await (await fetch(`${BASE}/api/bd-leads`, { headers: RH })).json()).bdLeads || [];
  ok('rival sees 0 of our BD deals', !rb.some(d => d.id === bd.id));
  const rr = (await (await fetch(`${BASE}/api/market-reports`, { headers: RH })).json()).reports || [];
  ok('rival sees 0 of our market reports', !rr.some(r => r.id === rep.id));
} else {
  ok('rival login', false, 'could not log in as rival tenant');
}

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
