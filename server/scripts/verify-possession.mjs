/**
 * Possession, and the two gates that stand between a buyer and their keys.
 *
 * WHAT THIS IS FOR
 *
 * The product could sell a flat, demand money for it and cancel it, and had
 * nothing at all for handing it over — which is where a residential project
 * generates its complaints, its retention releases and its RERA exposure.
 *
 * The gates are the whole point, and they are gates because of where a handover
 * happens: at a site office, signed by whoever is standing there, with a family
 * in front of them who have driven across the city for their keys. "There are
 * three open leaks" and "eleven lakh is still owing" cannot be things somebody
 * is expected to remember to check.
 *
 *   - an offer of possession requires an occupancy certificate. Offering
 *     possession of a building nobody may lawfully occupy is the complaint that
 *     gets filed, so it is a NOT NULL rather than a validation.
 *   - acceptance is blocked by open MAJOR or CRITICAL snags, and by an
 *     outstanding balance. Minor snags do not block: a gate that fires on a
 *     chipped skirting board is one people learn to override.
 *   - both can be overridden, because builders do decide to hand over anyway —
 *     and when they do, the outstanding balance is frozen onto the record and
 *     printed on the acknowledgement.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'ps' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, address, phone, currency)
     VALUES ($1,$1,$2,$3,'BKC, Mumbai','+91 22 4000 1000','INR') RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@ps.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Ops',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@ps.test`;
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
    `INSERT INTO projects (tenant_id, name) VALUES ($1,'Skyline Heights') RETURNING id`, [t.id])).rows[0];
  return { tenantId: t.id, token, projectId: project.id };
}

/** A booking with a consideration and a chosen amount actually received. */
async function booking(w, { code, consideration, received }) {
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code) VALUES ($1,$2,$3) RETURNING id`,
    [w.tenantId, w.projectId, code])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1,$2,$3,'+91 98200 00006') RETURNING id`,
    [w.tenantId, `Buyer ${code}`, `buy-${code}-${MARK}@ps.test`])).rows[0];
  const b = (await admin.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`,
    [w.tenantId, lead.id, unit.id, consideration])).rows[0];
  if (received > 0) {
    const s = (await admin.query(
      `INSERT INTO payment_schedules (tenant_id, booking_id, sequence, milestone_name, due_date, amount)
       VALUES ($1,$2,1,'Full',CURRENT_DATE,$3) RETURNING id`,
      [w.tenantId, b.id, consideration])).rows[0];
    await admin.query(
      `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
       VALUES ($1,$2,$3,CURRENT_DATE,'bank_transfer')`, [w.tenantId, s.id, received]);
  }
  return b.id;
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });
const patch = (token, path, body) => api(token, path, { method: 'PATCH', body: JSON.stringify(body) });

const A = await workspace('a', ['view_bookings', 'manage_bookings']);
const B = await workspace('b', ['view_bookings', 'manage_bookings']);

console.log('\n=== AN OFFER NEEDS AN OCCUPANCY CERTIFICATE ===');
const paid = await booking(A, { code: 'A-1201', consideration: 8000000, received: 8000000 });
const noOc = await post(A.token, '/api/possessions', { bookingId: paid });
ok('an offer without an OC reference is refused', noOc.status === 400, String(noOc.status));

// The database refuses it too, not just the schema on the route.
const dbLevel = await admin.query(
  `INSERT INTO possessions (tenant_id, booking_id, oc_reference) VALUES ($1,$2,'   ')`,
  [A.tenantId, paid]).then(() => 'inserted', e => e.code);
ok('and a blank one is refused by the database itself', dbLevel === '23514', String(dbLevel));

const offer = await post(A.token, '/api/possessions', {
  bookingId: paid, ocReference: 'OC/MUM/2026/8814', ocDatedOn: '2026-07-15',
});
ok('with a certificate, possession is offered', offer.status === 201, String(offer.status));
const p1 = (await offer.json()).possession;
ok('and starts as offered', p1.status === 'offered', p1.status);
ok('the outstanding balance is visible from the start', Number(p1.duesNow) === 0, String(p1.duesNow));

const dup = await post(A.token, '/api/possessions', { bookingId: paid, ocReference: 'OC/X' });
ok('a second live offer for the same flat is refused', dup.status === 409, String(dup.status));

console.log('\n=== SNAGS BLOCK BY SEVERITY, NOT BY COUNT ===');
const minor = await post(A.token, `/api/possessions/${p1.id}/snags`, {
  description: 'Socket cover chipped in the second bedroom', location: 'Bedroom 2',
  category: 'electrical', severity: 'minor',
});
ok('a minor snag is raised', minor.status === 201, String(minor.status));

const after = (await (await api(A.token, `/api/possessions/${p1.id}`)).json()).possession;
ok('raising a snag records the inspection', after.status === 'inspected', after.status);
ok('but a minor snag does not block', Number(after.blockingSnags) === 0, String(after.blockingSnags));

const acceptWithMinor = await patch(A.token, `/api/possessions/${p1.id}`, {
  status: 'accepted', receivedBy: 'Mr R Kumar',
});
ok('so possession can be taken with it open', acceptWithMinor.status === 200, String(acceptWithMinor.status));
const accepted = (await acceptWithMinor.json()).possession;
ok('the handover date is stamped', !!accepted.acceptedOn);
ok('and who took the keys is recorded', accepted.receivedBy === 'Mr R Kumar', accepted.receivedBy);

console.log('\n=== A MAJOR SNAG DOES BLOCK ===');
const leaky = await booking(A, { code: 'A-1202', consideration: 8000000, received: 8000000 });
const p2 = (await (await post(A.token, '/api/possessions', {
  bookingId: leaky, ocReference: 'OC/MUM/2026/8815',
})).json()).possession;
await post(A.token, `/api/possessions/${p2.id}/snags`, {
  description: 'Water ingress at the kitchen window during rain', location: 'Kitchen',
  category: 'civil', severity: 'critical',
});
const blocked = await patch(A.token, `/api/possessions/${p2.id}`, {
  status: 'accepted', receivedBy: 'Ms P Nair',
});
ok('acceptance is refused while a critical snag is open', blocked.status === 409, String(blocked.status));
const blockedBody = await blocked.json();
ok('and says how many are in the way', Number(blockedBody.blockingSnags) === 1, JSON.stringify(blockedBody.blockingSnags));

console.log('\n=== A RESOLVED SNAG SAYS HOW AND WHEN ===');
const snags = (await (await api(A.token, `/api/possessions/${p2.id}`)).json()).possession.snags;
const critical = snags.find(s => s.severity === 'critical');
const noWords = await patch(A.token, `/api/snags/${critical.id}`, { status: 'resolved' });
ok('resolving without an account of it is refused', noWords.status === 400, String(noWords.status));

const fixed = await patch(A.token, `/api/snags/${critical.id}`, {
  status: 'resolved', resolution: 'Window frame re-sealed and re-tested under a hose test.',
});
ok('with one, it is resolved', fixed.status === 200, String(fixed.status));
ok('and the resolution date is stamped', !!(await fixed.json()).snag.resolvedOn);

const nowClear = await patch(A.token, `/api/possessions/${p2.id}`, {
  status: 'accepted', receivedBy: 'Ms P Nair',
});
ok('possession can then be taken', nowClear.status === 200, String(nowClear.status));

console.log('\n=== MONEY BLOCKS TOO, AND THE OVERRIDE IS ON THE RECORD ===');
// Handing over the keys is the last leverage a builder has. Once they are gone
// the balance is a lawsuit.
const owing = await booking(A, { code: 'A-1203', consideration: 8000000, received: 6900000 });
const p3 = (await (await post(A.token, '/api/possessions', {
  bookingId: owing, ocReference: 'OC/MUM/2026/8816',
})).json()).possession;
ok('the outstanding balance is computed, not asked for',
   Math.abs(Number(p3.duesNow) - 1100000) < 0.01, String(p3.duesNow));

const refused = await patch(A.token, `/api/possessions/${p3.id}`, {
  status: 'accepted', receivedBy: 'Mr S Iyer',
});
ok('acceptance is refused with a balance owing', refused.status === 409, String(refused.status));
ok('and the amount is named', Math.abs(Number((await refused.json()).duesOutstanding) - 1100000) < 0.01);

const forced = await patch(A.token, `/api/possessions/${p3.id}`, {
  status: 'accepted', receivedBy: 'Mr S Iyer', force: true,
});
ok('a builder can override', forced.status === 200, String(forced.status));
const forcedBody = (await forced.json()).possession;
ok('and the balance is FROZEN onto the record, not lost',
   Math.abs(Number(forcedBody.duesOutstanding) - 1100000) < 0.01, String(forcedBody.duesOutstanding));

const noName = await booking(A, { code: 'A-1204', consideration: 100, received: 100 });
const p4 = (await (await post(A.token, '/api/possessions', {
  bookingId: noName, ocReference: 'OC/MUM/2026/8817',
})).json()).possession;
const anon = await patch(A.token, `/api/possessions/${p4.id}`, { status: 'accepted' });
ok('a handover with nobody\'s name on it is refused', anon.status === 400, String(anon.status));

console.log('\n=== THE DOCUMENT CHANGES WITH THE STATUS ===');
const { default: zlib } = await import('node:zlib');
const textOf = async (res) => {
  const b = Buffer.from(await res.arrayBuffer());
  let out = ''; const raw = b.toString('latin1'); let m; const re = /stream\r?\n([\s\S]*?)endstream/g;
  while ((m = re.exec(raw)) !== null) {
    const by = Buffer.from(m[1], 'latin1');
    let c; try { c = zlib.inflateSync(by).toString('latin1'); } catch { c = by.toString('latin1'); }
    for (const t of c.matchAll(/<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\)])*\)/g))
      out += t[1] !== undefined ? Buffer.from(t[1].replace(/\s+/g, ''), 'hex').toString('latin1')
                                : t[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
  }
  return { text: out, bytes: b };
};

const offerDoc = await api(A.token, `/api/possessions/${p2.id}/pdf`);
ok('the letter renders', offerDoc.status === 200, String(offerDoc.status));
const acceptedDoc = await textOf(await api(A.token, `/api/possessions/${p2.id}/pdf`));
const says = (t, p) => t.replace(/\s+/g, '').includes(p.replace(/\s+/g, ''));
ok('it is a complete PDF', acceptedDoc.bytes.subarray(0, 5).toString() === '%PDF-'
   && acceptedDoc.bytes.subarray(-1024).toString('latin1').includes('%%EOF'));
ok('once taken, it is a handover acknowledgement', says(acceptedDoc.text, 'Handover Acknowledgement'));
ok('and cites the occupancy certificate', says(acceptedDoc.text, 'OC/MUM/2026/8815'));

const forcedDoc = await textOf(await api(A.token, `/api/possessions/${p3.id}/pdf`));
ok('a forced handover prints the balance on the document',
   says(forcedDoc.text, 'remained outstanding on the date of handover'));
ok('and reserves the right to recover it', says(forcedDoc.text, 'without prejudice'));

const pendingBooking = await booking(A, { code: 'A-1205', consideration: 8000000, received: 0 });
const p5 = (await (await post(A.token, '/api/possessions', {
  bookingId: pendingBooking, ocReference: 'OC/MUM/2026/8818',
})).json()).possession;
const offerText = (await textOf(await api(A.token, `/api/possessions/${p5.id}/pdf`))).text;
ok('before handover it is an offer of possession', says(offerText, 'Offer of Possession'));
ok('and states the amount payable before the keys are given',
   says(offerText, 'payable before possession is handed over'));
ok('and that maintenance runs from the OFFER, not the handover',
   says(offerText, 'from the date of the offer of possession'));

console.log('\n=== LIFECYCLE AND SCOPE ===');
const reaccept = await patch(A.token, `/api/possessions/${p2.id}`, { status: 'accepted', receivedBy: 'X' });
ok('an accepted possession cannot be accepted again', reaccept.status === 409, String(reaccept.status));

const cancelled = await booking(A, { code: 'A-1206', consideration: 100, received: 0 });
await admin.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [cancelled]);
const onCancelled = await post(A.token, '/api/possessions', { bookingId: cancelled, ocReference: 'OC/Y' });
ok('a cancelled booking cannot be handed over', onCancelled.status === 409, String(onCancelled.status));

const cross = await api(B.token, `/api/possessions/${p1.id}`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));
const crossPdf = await api(B.token, `/api/possessions/${p1.id}/pdf`);
ok('and cannot render the letter either', crossPdf.status === 404, String(crossPdf.status));

const readOnly = await workspace('c', ['view_bookings']);
const denied = await post(readOnly.token, '/api/possessions', { bookingId: paid, ocReference: 'OC/Z' });
ok('a read-only user cannot offer possession', denied.status === 403, String(denied.status));

for (const w of [A, B, readOnly]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
