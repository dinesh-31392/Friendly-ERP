/**
 * Separation of duties on the land and BD pipelines.
 *
 * THE DEFECT THIS SUITE WAS WRITTEN FOR
 *
 * Three permissions have existed since migration 028 — approve_land_qualify,
 * approve_land_convert, approve_bd_handoff. They were granted to roles, listed
 * in the catalog, and read by the SPA: Land.tsx picks its buttons from all
 * three, and BD.tsx shows a maker the words "Awaiting hand-off approval".
 *
 * No route ever checked one. Every land and BD status change gated on
 * manage_land / manage_bd alone. So the control failed in both directions at
 * once, which is why neither half was noticed:
 *
 *   the maker approved their own work   a land_manager could log a parcel and
 *                                       convert it to a project the same
 *                                       afternoon, and the audit trail showed a
 *                                       two-step approval that never happened
 *   the checker was locked out          a bd_manager holds approve_land_qualify
 *                                       and deliberately NOT manage_land, so the
 *                                       API refused the single action the role
 *                                       exists to perform — while the SPA
 *                                       rendered the button for them
 *
 * The second half is what makes "just require both keys" wrong. For an approval
 * transition the approval key REPLACES the maker key; it does not add to it.
 *
 * WHY THE POSITIVE CONTROLS CARRY THE WEIGHT HERE
 *
 * A suite of only negatives passes on a pipeline where nobody can move anything.
 * "The maker cannot qualify" is satisfied just as well by a 500 on every PATCH.
 * So each refusal below is paired with the same call succeeding for the person
 * who should be able to make it, and the maker is separately shown still able to
 * do the whole of their own job.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'apg' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const tenant = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} co`, `${MARK}-co`, `${MARK}@apg.test`])).rows[0];

async function member(slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenant.id, slug])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  const email = `${MARK}-${slug}@apg.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [tenant.id, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { token, slug, roleId: role.id };
}

const api = async (who, method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${who.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// The production role set, with the grants the seeders actually write.
const maker = await member('land_manager',
  ['view_dashboard', 'view_land', 'manage_land', 'view_bd']);
const checker = await member('bd_manager',
  ['view_dashboard', 'view_bd', 'manage_bd', 'view_land', 'approve_land_qualify']);
const owner = await member('builder_admin',
  ['view_dashboard', 'view_land', 'manage_land', 'approve_land_qualify', 'approve_land_convert',
   'view_bd', 'manage_bd', 'approve_bd_handoff']);

const newParcel = async (who, name) =>
  (await api(who, 'POST', '/api/land-leads',
    { ownerName: name, surveyNumber: `S-${Math.floor(Math.random() * 900 + 100)}`, city: 'Pune', areaAcres: 2 }))
    .body.landLead;

// ── the maker can do the whole of their own job ────────────────────────────
console.log('\n=== THE MAKER IS NOT LOCKED OUT OF THEIR OWN WORK ===');
// Without this block, every refusal below would also pass on a pipeline that
// simply rejects all writes.
const p1 = await newParcel(maker, 'Wakad Owner');
ok('a land manager can log a parcel', !!p1, JSON.stringify(p1));
ok('...move it through diligence',
  (await api(maker, 'PATCH', `/api/land-leads/${p1.id}`, { status: 'property_details' })).status === 200);
ok('...run a feasibility study on it',
  (await api(maker, 'POST', '/api/feasibility', { landLeadId: p1.id, score: 72, costPerSqft: 8500, saleableArea: 40000 })).status === 201);
ok('...record a title document',
  (await api(maker, 'POST', '/api/land-documents', { landLeadId: p1.id, docType: 'title_deed', fileName: '7-12.pdf' })).status === 201);
ok('...and reject a parcel that does not work',
  (await api(maker, 'PATCH', `/api/land-leads/${p1.id}`, { status: 'rejected', rejectionReason: 'Encumbered' })).status === 200);

// ── but not sign off on it ─────────────────────────────────────────────────
console.log('\n=== AND CANNOT APPROVE IT ===');
const p2 = await newParcel(maker, 'Baner Owner');
const selfQualify = await api(maker, 'PATCH', `/api/land-leads/${p2.id}`, { status: 'qualified' });
ok('the maker cannot qualify their own parcel',
  selfQualify.status === 403, `${selfQualify.status} ${selfQualify.body.error ?? ''}`);
ok('...and is told which key is missing, not simply refused',
  selfQualify.body.error === 'Missing permission: approve_land_qualify', selfQualify.body.error);
const selfConvert = await api(maker, 'PATCH', `/api/land-leads/${p2.id}`, { status: 'converted_to_project' });
ok('the maker cannot convert a parcel into a project',
  selfConvert.status === 403, `${selfConvert.status} ${selfConvert.body.error ?? ''}`);

// The refusal has to be real, not cosmetic: a 403 that still wrote the row is
// the failure mode a status-code assertion alone would miss.
const after = (await api(maker, 'GET', '/api/land-leads')).body.landLeads.find(l => l.id === p2.id);
ok('and the refused approval did not write the status anyway',
  after.status !== 'qualified' && after.status !== 'converted_to_project', after.status);

// ── the checker can, holding ONLY the approval key ─────────────────────────
console.log('\n=== THE CHECKER CAN, WITHOUT HOLDING THE MAKER KEY ===');
// This is the half that was broken in the other direction. bd_manager has no
// manage_land at all; requiring both keys would leave the role useless.
const qual = await api(checker, 'PATCH', `/api/land-leads/${p2.id}`, { status: 'qualified' });
ok('a bd_manager holding only approve_land_qualify can qualify the parcel',
  qual.status === 200, `${qual.status} ${qual.body.error ?? ''}`);
ok('...and the parcel really is qualified now',
  (await api(checker, 'GET', '/api/land-leads')).body.landLeads.find(l => l.id === p2.id).status === 'qualified');
// Approving is not editing. A checker without manage_land must not be able to
// ride an approval call to change fields they have no rights to.
const smuggle = await api(checker, 'PATCH', `/api/land-leads/${p2.id}`,
  { status: 'qualified', rejectionReason: 'quietly rewritten by the approver' });
ok('but cannot smuggle an edit through the approval call',
  smuggle.status === 403, `${smuggle.status} ${smuggle.body.error ?? ''}`);
ok('...and the field they tried to change is untouched',
  !((await api(owner, 'GET', '/api/land-leads')).body.landLeads.find(l => l.id === p2.id).rejectionReason ?? '')
    .includes('quietly rewritten'));

// ── verifying a document is attestation, not filing ────────────────────────
console.log('\n=== THE UPLOADER DOES NOT VERIFY THEIR OWN DOCUMENT ===');
// Same inversion as the status gates, one level down: Land.tsx gates this
// control on approve_land_qualify while the API asked for manage_land, so the
// checker was shown a button that 403'd and the uploader could attest to their
// own title deed.
const doc = (await api(maker, 'POST', '/api/land-documents',
  { landLeadId: p2.id, docType: 'title_deed', fileName: '7-12-extract.pdf' })).body.document;
ok('the maker can file a title document', !!doc);
const selfVerify = await api(maker, 'PATCH', `/api/land-documents/${doc.id}`, { verificationStatus: 'verified' });
ok('but cannot verify the document they filed',
  selfVerify.status === 403, `${selfVerify.status} ${selfVerify.body.error ?? ''}`);
ok('the checker can verify it',
  (await api(checker, 'PATCH', `/api/land-documents/${doc.id}`, { verificationStatus: 'verified' })).status === 200);
ok('...and the document really is marked verified',
  (await api(maker, 'GET', `/api/land-documents?landLeadId=${p2.id}`))
    .body.documents.find(d => d.id === doc.id).verificationStatus === 'verified');

// ── conversion is a second, separate signature ─────────────────────────────
console.log('\n=== CONVERSION IS A SECOND SIGNATURE, NOT THE SAME ONE ===');
const convByChecker = await api(checker, 'PATCH', `/api/land-leads/${p2.id}`, { status: 'converted_to_project' });
ok('the qualifier cannot also convert — approve_land_convert is a distinct key',
  convByChecker.status === 403, `${convByChecker.status} ${convByChecker.body.error ?? ''}`);
ok('the builder admin can convert',
  (await api(owner, 'PATCH', `/api/land-leads/${p2.id}`, { status: 'converted_to_project' })).status === 200);

// ── BD hand-off ────────────────────────────────────────────────────────────
console.log('\n=== HANDING A JV TO THE LAND TEAM IS AN APPROVAL ===');
const deal = (await api(checker, 'POST', '/api/bd-leads',
  { counterpartyName: 'Baner Landowners LLP', opportunityType: 'jv', city: 'Pune' })).body.bdLead;
ok('a bd_manager can open an opportunity', !!deal);
ok('...and negotiate it through the stages',
  (await api(checker, 'PATCH', `/api/bd-leads/${deal.id}`, { stage: 'terms_negotiation' })).status === 200);
const selfHand = await api(checker, 'PATCH', `/api/bd-leads/${deal.id}`, { stage: 'handed_to_land' });
ok('but cannot hand their own deal to the land team',
  selfHand.status === 403, `${selfHand.status} ${selfHand.body.error ?? ''}`);
ok('the builder admin can',
  (await api(owner, 'PATCH', `/api/bd-leads/${deal.id}`, { stage: 'handed_to_land' })).status === 200);
// Closing a deal as lost is the maker's own call — an approval gate on the
// hand-off must not have swept up every other stage change.
const deal2 = (await api(checker, 'POST', '/api/bd-leads', { counterpartyName: 'Hinjewadi Owner' })).body.bdLead;
ok('and closing a deal lost is still the maker’s own call',
  (await api(checker, 'PATCH', `/api/bd-leads/${deal2.id}`, { stage: 'closed_lost', closedLostReason: 'Price' })).status === 200);

// ── an approval carries its own link, and nothing else ─────────────────────
console.log('\n=== THE APPROVAL MAY CARRY ITS OWN LINK, BUT NOT A FREE EDIT ===');
// Both real flows send the link WITH the status: landService converts with
// {status:'converted_to_project', projectId} and bdService hands off with
// {stage:'handed_to_land', landLeadId}. Treating that link as a smuggled edit
// would refuse the very call the approval exists to make — so it is allowed,
// and every other field still is not.
const approver = await member('land_approver', ['view_land', 'approve_land_convert']);
const project = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status)
   VALUES ($1,'Converted Site','Pune','pre_launch') RETURNING id`, [tenant.id])).rows[0];
const p3 = await newParcel(maker, 'Hinjewadi Owner');
await api(checker, 'PATCH', `/api/land-leads/${p3.id}`, { status: 'qualified' });

const carried = await api(approver, 'PATCH', `/api/land-leads/${p3.id}`,
  { status: 'converted_to_project', projectId: project.id });
ok('an approver holding only approve_land_convert can convert AND link the project',
  carried.status === 200, `${carried.status} ${carried.body.error ?? ''}`);
ok('...and the project really is linked',
  (await api(owner, 'GET', '/api/land-leads')).body.landLeads.find(l => l.id === p3.id).projectId === project.id);

const p4 = await newParcel(maker, 'Kharadi Owner');
await api(checker, 'PATCH', `/api/land-leads/${p4.id}`, { status: 'qualified' });
const extra = await api(approver, 'PATCH', `/api/land-leads/${p4.id}`,
  { status: 'converted_to_project', projectId: project.id, rejectionReason: 'not their field to set' });
ok('but a field outside the approval still needs the maker key',
  extra.status === 403, `${extra.status} ${extra.body.error ?? ''}`);
// The refusal must be total — a partial write would convert the parcel while
// rejecting the edit, leaving the approval half-applied.
ok('...and the refused call wrote nothing at all',
  (await api(owner, 'GET', '/api/land-leads')).body.landLeads.find(l => l.id === p4.id).status === 'qualified');

// ── migration 067: nobody is stranded ──────────────────────────────────────
console.log('\n=== NO WORKSPACE IS LEFT WITH A GATE NOBODY CAN PASS ===');
// Turning these gates on could strand a customised workspace: if no role holds
// approve_land_convert, the pipeline stops at 'qualified' forever. 067 backfills
// the key to the maker ONLY where the whole tenant lacks a holder.
const solo = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} solo`, `${MARK}-solo`, `${MARK}-solo@apg.test`])).rows[0];
const soloRole = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'land_only',false) RETURNING id`, [solo.id])).rows[0];
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'view_land'), ($1,'manage_land')`, [soloRole.id]);

const backfill = await admin.query(`
  INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, k.approval
    FROM roles r
    JOIN (VALUES ('manage_land','approve_land_qualify'), ('manage_land','approve_land_convert'),
                 ('manage_bd','approve_bd_handoff')) AS k(maker, approval) ON true
   WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = k.maker)
     AND NOT EXISTS (SELECT 1 FROM roles peer JOIN role_permissions prp ON prp.role_id = peer.id
                      WHERE peer.tenant_id = r.tenant_id AND prp.permission_key = k.approval)
     AND EXISTS (SELECT 1 FROM permissions p WHERE p.key = k.approval)
     AND r.tenant_id = $1
  ON CONFLICT DO NOTHING RETURNING permission_key`, [solo.id]);
const granted = backfill.rows.map(r => r.permission_key).sort();
ok('a workspace with no approver at all gets the keys, so its pipeline still moves',
  granted.join(',') === 'approve_land_convert,approve_land_qualify', granted.join(','));

// And the workspace that DOES have a split keeps it — the backfill must not
// flatten a separation of duties a builder deliberately configured.
const reapply = await admin.query(`
  INSERT INTO role_permissions (role_id, permission_key)
  SELECT r.id, k.approval
    FROM roles r
    JOIN (VALUES ('manage_land','approve_land_qualify')) AS k(maker, approval) ON true
   WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = k.maker)
     AND NOT EXISTS (SELECT 1 FROM roles peer JOIN role_permissions prp ON prp.role_id = peer.id
                      WHERE peer.tenant_id = r.tenant_id AND prp.permission_key = k.approval)
     AND r.tenant_id = $1
  ON CONFLICT DO NOTHING RETURNING 1`, [tenant.id]);
ok('a workspace that already separates maker from checker is left alone',
  reapply.rowCount === 0, `${reapply.rowCount} row(s) granted`);
// Proof the split survived the backfill, asserted through the API rather than
// the grant table: the maker is still refused after 067 has run.
ok('...and its maker is still refused afterwards',
  (await api(maker, 'PATCH', `/api/land-leads/${(await newParcel(maker, 'Post-backfill')).id}`,
    { status: 'qualified' })).status === 403);

// A standing guard, not a fixture: the risk 067 cannot cover is a FUTURE
// workspace. Self-serve signup builds builder_admin from the catalog minus
// BUILDER_ADMIN_EXCLUDES, so adding an approval key to that list — or dropping
// one from the catalog — would strand every workspace created afterwards, and
// nothing else would notice. Asserted across every tenant in the database.
const stranded = await admin.query(`
  SELECT t.slug, k.approval
    FROM tenants t
    JOIN (VALUES ('manage_land','approve_land_qualify'), ('manage_land','approve_land_convert'),
                 ('manage_bd','approve_bd_handoff')) AS k(maker, approval) ON true
   WHERE EXISTS (SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
                  WHERE r.tenant_id = t.id AND rp.permission_key = k.maker)
     AND NOT EXISTS (SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
                      WHERE r.tenant_id = t.id AND rp.permission_key = k.approval)`);
ok('every workspace running land or BD has somebody who can approve',
  stranded.rowCount === 0, stranded.rows.map(r => `${r.slug}:${r.approval}`).join(', '));

await admin.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenant.id, solo.id]]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
