/**
 * The public lead-capture surface — the one endpoint strangers can write to.
 *
 * WHY THIS DID NOT EXIST BEFORE, AND SHOULD HAVE
 *
 * /api/public/leads is unauthenticated by design: it is what a builder's own
 * website posts an enquiry to. It had no coverage at all, which is how a 500
 * on ordinary input survived — passing `projectId` as a project NAME rather
 * than a uuid raised 22P02 inside the handler, so the request failed and the
 * enquiry was lost. On a lead-capture endpoint a lost request is a lost sale,
 * and nothing in the product would have reported it.
 *
 * Everything here is written from the point of view of the snippets the
 * Integrations panel hands to builders: if a payload in this file stops
 * working, a snippet somebody has already pasted into their website has
 * stopped working too.
 */
import pg from 'pg';

// CI runs the API on 4055; API_BASE points the suite at another instance.
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'PUBCAP';
const clean = async () => {
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
};
await clean();

const { rows: [tA] } = await admin.query(`SELECT id, slug FROM tenants WHERE slug='platform'`);
const { rows: [tB] } = await admin.query(`SELECT id, slug FROM tenants WHERE slug='rivaltest'`);
const { rows: [proj] } = await admin.query(
  `SELECT id, name FROM projects WHERE tenant_id=$1 LIMIT 1`, [tA.id]);

const capture = async (body) => {
  const r = await fetch(BASE + '/api/public/leads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const leadRow = async (name) => (await admin.query(
  `SELECT tenant_id, project, budget, configuration FROM leads WHERE name=$1`, [name])).rows[0];

// ── The shape the generated snippets actually send ─────────────────────────
console.log('\n=== THE SNIPPETS\' OWN PAYLOADS ===');
const form = await capture({ slug: tA.slug, name: `${MARK} Form`, phone: '9800001234', email: 'f@t.local' });
ok('the website form snippet captures', form.status === 201 && !!form.body?.leadId, `${form.status}`);

const sample = await capture({
  slug: tA.slug, name: `${MARK} Sample`, email: 'r@e.com', phone: '+91 98220 11223',
  budget: 15000000, configuration: '3 BHK', timeline: '3-6 months' });
ok('the documented sample payload captures', sample.status === 201, `${sample.status}`);
const sampleRow = await leadRow(`${MARK} Sample`);
ok('…and its optional fields are actually stored',
   Number(sampleRow?.budget) === 15000000 && sampleRow?.configuration === '3 BHK',
   `budget=${sampleRow?.budget} config=${sampleRow?.configuration}`);

// ── The regression this suite exists for ───────────────────────────────────
console.log('\n=== A MALFORMED projectId MUST NOT LOSE THE ENQUIRY ===');
// projects.id is uuid. Sending a name or slug — the obvious mistake, and one
// the old sample payload actively encouraged — used to raise 22P02 and 500.
const badProj = await capture({ slug: tA.slug, name: `${MARK} BadProj`, phone: '9800007777', projectId: 'skyline-heights' });
ok('a non-uuid projectId still captures the lead', badProj.status === 201, `${badProj.status}`);
ok('…with no project attributed rather than a failed request',
   (await leadRow(`${MARK} BadProj`))?.project === '', `${(await leadRow(`${MARK} BadProj`))?.project}`);

const goodProj = await capture({ slug: tA.slug, name: `${MARK} GoodProj`, phone: '9800006666', projectId: proj.id });
ok('a real project uuid is attributed', goodProj.status === 201
   && (await leadRow(`${MARK} GoodProj`))?.project === proj.name,
   `${(await leadRow(`${MARK} GoodProj`))?.project}`);

// ── Tenant resolution is by slug, server-side ──────────────────────────────
console.log('\n=== THE WORKSPACE COMES FROM THE SLUG, AND ONLY THE SLUG ===');
ok('the lead lands in the tenant that owns the slug',
   (await leadRow(`${MARK} Form`))?.tenant_id === tA.id);
const rival = await capture({ slug: tB.slug, name: `${MARK} Rival`, phone: '9800005555' });
ok('a different slug lands in a different tenant',
   rival.status === 201 && (await leadRow(`${MARK} Rival`))?.tenant_id === tB.id);
const unknown = await capture({ slug: 'no-such-workspace', name: `${MARK} Ghost`, phone: '9800004444' });
ok('an unknown slug is 404, not a silent 201', unknown.status === 404, `${unknown.status}`);
ok('…and wrote nothing', !(await leadRow(`${MARK} Ghost`)));

// ── Bot handling ───────────────────────────────────────────────────────────
console.log('\n=== HONEYPOT ===');
const bot = await capture({ slug: tA.slug, name: `${MARK} Bot`, phone: '9800009999', hp: 'gotcha' });
ok('a filled honeypot is acknowledged with 200', bot.status === 200, `${bot.status}`);
ok('…and is reported as dropped', bot.body?.dropped === true);
ok('…and no lead is written', !(await leadRow(`${MARK} Bot`)));

// ── Unknown fields ─────────────────────────────────────────────────────────
console.log('\n=== UNKNOWN FIELDS ARE STRIPPED, NOT REJECTED ===');
// Documented rather than asserted as desirable: Fastify's AJV defaults to
// removeAdditional, so `source` and `message` — which the OLD sample payload
// told integrators to send — vanish without an error. Anyone building against
// that sample would have watched two values disappear with nothing to explain
// it. The sample no longer mentions them; this pins the behaviour so the next
// person to read it knows which way it fails.
const extra = await capture({ slug: tA.slug, name: `${MARK} Extra`, phone: '9800003333', source: 'Zapier', message: 'hi' });
ok('a payload with unknown fields is accepted', extra.status === 201, `${extra.status}`);
ok('…and the known fields still land', !!(await leadRow(`${MARK} Extra`)));

// ── Required fields ────────────────────────────────────────────────────────
console.log('\n=== REQUIRED FIELDS ===');
const noPhone = await capture({ slug: tA.slug, name: `${MARK} NoPhone` });
ok('a missing phone is a 400', noPhone.status === 400, `${noPhone.status}`);
const noName = await capture({ slug: tA.slug, phone: '9800002222' });
ok('a missing name is a 400', noName.status === 400, `${noName.status}`);

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
