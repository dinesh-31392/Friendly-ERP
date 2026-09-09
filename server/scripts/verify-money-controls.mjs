/**
 * Three controls the interface promised and the API did not keep.
 *
 * Each was found by working the product as a role rather than by reading it, and
 * each fails in a way a status-code audit misses:
 *
 *   the discount    Bookings.tsx decided approval in the BROWSER — it computed
 *                   `parked` and `discountApprovedBy` and posted the result,
 *                   while the route gated on create_quotations and took both as
 *                   ordinary columns. A rep self-approved ₹9,00,000 against the
 *                   live API, nine times the default threshold.
 *   the RA bill     Accounts.tsx draws two signatures on a contractor payment;
 *                   the route gated both on manage_finance and merely STAMPED
 *                   whichever approver the transition implied. The site engineer
 *                   who owns stage one was refused it, and the accountant could
 *                   sign both halves alone.
 *   the tower       /api/towers gated on view_inventory though a tower carries
 *                   no commercial data. Six of ten roles had "Projects" in their
 *                   sidebar and read "0 Towers" — a wrong number, not an error.
 *
 * THE DISCIPLINE THIS SUITE KEEPS
 *
 * A 2xx proves the request was accepted, never that it persisted, and never that
 * the server did what the client asked rather than what the rules require. So
 * every write here is READ BACK as a different session, and the assertions are
 * about the stored row — who is recorded as approver, which status it holds.
 *
 * And every refusal is paired with the same action succeeding for whoever should
 * be able to take it. A suite of only negatives passes on a product where the
 * money screens are broken for everybody.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'mc' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const PIPELINE = { stages: [{ key: 'new', id: 'new', label: 'New', core: true }] };
const tenant = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} co`, `${MARK}-co`, `${MARK}@mc.test`])).rows[0];
await admin.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   VALUES ($1,'lead','pipeline',1,true,$2) ON CONFLICT DO NOTHING`,
  [tenant.id, JSON.stringify(PIPELINE)]);

async function member(slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenant.id, slug])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  const email = `${MARK}-${slug}@mc.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [tenant.id, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { userId: u.id, token, slug };
}

const api = async (who, method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// The production grants, as the seeders actually write them.
const rep = await member('sales_executive',
  ['view_dashboard', 'view_leads', 'manage_own_leads', 'view_bookings', 'create_quotations', 'view_inventory']);
const salesMgr = await member('sales_manager',
  ['view_dashboard', 'view_leads', 'manage_leads', 'view_bookings', 'create_quotations', 'approve_discounts', 'view_inventory']);
const siteEng = await member('site_engineer',
  ['view_dashboard', 'view_projects', 'view_execution', 'view_finance', 'signoff_ra_bills']);
const accountant = await member('accountant',
  ['view_dashboard', 'view_projects', 'view_accounts', 'view_finance', 'manage_finance', 'approve_vendor_bills']);

const project = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status)
   VALUES ($1,'Riverfront','Pune','under_construction') RETURNING id`, [tenant.id])).rows[0];
const tower = (await admin.query(
  `INSERT INTO towers (tenant_id, project_id, name, floors, units_per_floor)
   VALUES ($1,$2,'Tower A',12,4) RETURNING id`, [tenant.id, project.id])).rows[0];
const unit = (await admin.query(
  `INSERT INTO units (tenant_id, project_id, tower_id, unit_code, unit_type, configuration,
                      floor, area_sqft, base_rate, floor_rise_rate, status)
   VALUES ($1,$2,$3,'A-1201','apartment','3BHK',12,1450,6200,25,'available') RETURNING id`,
  [tenant.id, project.id, tower.id])).rows[0];
const lead = (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, stage, assigned_to)
   VALUES ($1,'Discount Buyer','9820011111','new',$2) RETURNING id`, [tenant.id, rep.userId])).rows[0];

const valid = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
const quote = (who, discount, extra = {}) => api(who, 'POST', '/api/quotations', {
  leadId: lead.id, unitId: unit.id, baseAmount: 9000000,
  discountAmount: discount, totalAmount: 9000000 - discount, validUntil: valid, ...extra,
});
/**
 * Read back as SOMEONE ELSE — a 201 says the request was accepted, not that the
 * row says what the rules require.
 *
 * The reader must hold view_bookings or the fetch 403s and this returns
 * undefined, which reads as "the assertion failed" when the truth is "the audit
 * never looked". That mistake is this suite's own subject matter, so it throws
 * rather than quietly answering nothing.
 */
const readQuote = async (id, reader = salesMgr) => {
  const r = await api(reader, 'GET', '/api/quotations');
  if (r.status !== 200) throw new Error(`read-back as ${reader.slug} was refused: ${r.status} ${r.body.error ?? ''}`);
  return (r.body.quotations ?? []).find(q => q.id === id);
};

// ── the discount ───────────────────────────────────────────────────────────
console.log('\n=== A REP CANNOT APPROVE THEIR OWN DISCOUNT ===');
// The exact payload the browser would never send, which is precisely why the
// server has to be the one deciding.
const sneaky = await quote(rep, 900000, { discountApprovedBy: rep.userId, status: 'draft' });
ok('the rep can still raise a quotation — the gate is not a blanket refusal',
  sneaky.status === 201, `${sneaky.status} ${sneaky.body.error ?? ''}`);
const parked = await readQuote(sneaky.body.quotation?.id);
ok('...but a ₹9,00,000 discount parks in pending_approval, whatever they asked for',
  parked?.status === 'pending_approval', parked?.status);
ok('...and the approver field they tried to stamp is empty',
  !parked?.discountApprovedBy, String(parked?.discountApprovedBy));

console.log('\n=== AND THE GATE ONLY BITES ABOVE THE THRESHOLD ===');
// Without this, "everything parks" would satisfy the assertions above while
// making the product unusable.
const small = await quote(rep, 5000);
const smallBack = await readQuote(small.body.quotation?.id);
ok('a ₹5,000 discount needs nobody and goes straight to draft',
  smallBack?.status === 'draft', smallBack?.status);
ok('...with no approver recorded, since no approval happened',
  !smallBack?.discountApprovedBy, String(smallBack?.discountApprovedBy));

console.log('\n=== SOMEONE WHO HOLDS THE KEY MAY SELF-APPROVE ===');
const mgrQuote = await quote(salesMgr, 900000);
const mgrBack = await readQuote(mgrQuote.body.quotation?.id, rep);   // read by the other party
ok('a sales manager’s large discount does NOT park', mgrBack?.status !== 'pending_approval', mgrBack?.status);
ok('...and the server stamps THEM as the approver, from the session not the body',
  mgrBack?.discountApprovedBy === salesMgr.userId, String(mgrBack?.discountApprovedBy));

console.log('\n=== RELEASING A PARKED QUOTATION IS THE APPROVAL ===');
const selfRelease = await api(rep, 'PATCH', `/api/quotations/${sneaky.body.quotation.id}`, { status: 'draft' });
ok('the rep cannot release their own parked quotation',
  selfRelease.status === 403, `${selfRelease.status} ${selfRelease.body.error ?? ''}`);
ok('...and it is still parked afterwards',
  (await readQuote(sneaky.body.quotation.id))?.status === 'pending_approval');
ok('the sales manager can release it',
  (await api(salesMgr, 'PATCH', `/api/quotations/${sneaky.body.quotation.id}`, { status: 'draft' })).status === 200);

// ── the RA bill ────────────────────────────────────────────────────────────
console.log('\n=== A CONTRACTOR PAYMENT TAKES TWO DIFFERENT SIGNATURES ===');
const vendor = (await admin.query(
  `INSERT INTO vendors (tenant_id, name, vendor_type, category, phone)
   VALUES ($1,'Sharma Constructions','contractor','civil','9820022222') RETURNING id`,
  [tenant.id])).rows[0];
const ra = await api(accountant, 'POST', '/api/ra-bills', {
  vendorId: vendor.id, projectId: project.id,
  workProgressPercentage: 40, grossAmount: 1200000, retentionAmount: 60000,
});
ok('finance can raise the RA bill', ra.status === 201, `${ra.status} ${ra.body.error ?? ''}`);
const raId = ra.body.raBill?.id;

// The dead control: the role the button belongs to was refused by the API.
const verify = await api(siteEng, 'PATCH', `/api/ra-bills/${raId}`, { status: 'pmc_approved' });
ok('the site engineer can verify progress — the button that used to 403',
  verify.status === 200, `${verify.status} ${verify.body.error ?? ''}`);

const financeVerify = await api(accountant, 'PATCH', `/api/ra-bills/${raId}`, { status: 'pmc_approved' });
ok('finance cannot verify site progress — that is the second pair of eyes',
  financeVerify.status === 403, `${financeVerify.status} ${financeVerify.body.error ?? ''}`);

const approve = await api(accountant, 'PATCH', `/api/ra-bills/${raId}`, { status: 'finance_approved' });
ok('finance can approve the bill', approve.status === 200, `${approve.status} ${approve.body.error ?? ''}`);
const siteApprove = await api(siteEng, 'PATCH', `/api/ra-bills/${raId}`, { status: 'finance_approved' });
ok('the site engineer cannot approve the payment they verified',
  siteApprove.status === 403, `${siteApprove.status} ${siteApprove.body.error ?? ''}`);

// The assertion that makes the whole thing worth having: TWO people, read from
// the stored row rather than inferred from two 200s.
const stored = (await admin.query(
  `SELECT status, pmc_approved_by, finance_approved_by FROM contractor_ra_bills WHERE id = $1`, [raId])).rows[0];
ok('the row records two DIFFERENT people, not one person twice',
  stored.pmc_approved_by === siteEng.userId
  && stored.finance_approved_by === accountant.userId
  && stored.pmc_approved_by !== stored.finance_approved_by,
  `${stored.pmc_approved_by} / ${stored.finance_approved_by}`);
ok('...and the bill really is finance-approved', stored.status === 'finance_approved', stored.status);

// ── the tower ──────────────────────────────────────────────────────────────
console.log('\n=== SEEING A PROJECT MEANS SEEING HOW MANY TOWERS IT HAS ===');
const towers = await api(siteEng, 'GET', '/api/towers');
ok('a site engineer with view_projects but no view_inventory can read towers',
  towers.status === 200 && (towers.body.towers ?? []).length === 1,
  `${towers.status} ${(towers.body.towers ?? []).length} row(s)`);
ok('...so the Projects page counts 1 tower rather than claiming 0',
  (towers.body.towers ?? [])[0]?.name === 'Tower A');
// And nothing commercial came with it.
const units = await api(siteEng, 'GET', '/api/units');
ok('but the priced inventory behind those towers is still refused',
  units.status === 403, `${units.status} ${units.body.error ?? ''}`);
ok('and they still cannot create a tower',
  (await api(siteEng, 'POST', '/api/towers', { projectId: project.id, name: 'Tower B' })).status === 403);

// ── the drift this suite could not otherwise see ───────────────────────────
console.log('\n=== EVERY WORKSPACE HAS SOMEBODY FOR EACH RA SIGNATURE ===');
/**
 * The cast above is built with explicit grants, so it proves the ROUTES are
 * right and nothing about how real workspaces are provisioned.
 *
 * Migration 068 gave approve_vendor_bills to existing accountants, but role
 * grants are also written by four code paths — seed.ts, tenantRoutes (self-serve
 * signup), the demo seeder, and the SPA's demo map — and those build workspaces
 * created AFTERWARDS. Updating the migration and not the four was exactly the
 * mistake made here: re-seeding the demo workspace produced an accountant who
 * could no longer approve a vendor bill, and the RA bill sat at pmc_approved
 * with nobody able to move it.
 *
 * Asserted across every tenant in the database, so a workspace provisioned by
 * any of those paths fails this the moment it exists.
 */
const stranded = await admin.query(`
  SELECT t.slug, k.approval
    FROM tenants t
    JOIN (VALUES ('signoff_ra_bills'), ('approve_vendor_bills')) AS k(approval) ON true
   WHERE EXISTS (SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
                  WHERE r.tenant_id = t.id AND rp.permission_key = 'manage_finance')
     AND NOT EXISTS (SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
                      WHERE r.tenant_id = t.id AND rp.permission_key = k.approval)`);
ok('no workspace can raise an RA bill it has nobody to sign',
  stranded.rowCount === 0, stranded.rows.map(r => `${r.slug}:${r.approval}`).join(', '));

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
