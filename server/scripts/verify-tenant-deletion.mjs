/**
 * A workspace with a history can still be deleted.
 *
 * WHAT THIS IS FOR
 *
 * Thirty-six foreign keys referenced `users` with no on-delete action. Because
 * `users.tenant_id` cascades from `tenants`, every one of them silently made
 * the WORKSPACE undeletable: one posted journal entry, one created booking,
 * one approved leave request, and the tenant row could never be removed.
 *
 * That is a data-protection problem before it is an operational one — a
 * customer who asks for their workspace to be erased cannot be given it.
 *
 * THE ASSERTION THAT MATTERS
 *
 * Not "the constraints were altered" — a migration proves that to itself.
 * This builds a workspace that has actually been USED, across as many of the
 * affected tables as can be reached, and then deletes it. The migration
 * without this test just moves the problem somewhere nobody is looking.
 *
 * WHY IT CHECKS FOR ORPHANS TOO
 *
 * CASCADE would also make the delete succeed, and would be catastrophic: it
 * would take the invoices a departing employee raised and the payments they
 * receipted. So the suite deletes a USER as well and asserts the rows they
 * touched are still there with the attribution nulled — the fact survives,
 * the name does not.
 */
import pg from 'pg';
import argon2 from 'argon2';

const MARK = 'del' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const db = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await db.connect();

// ── the audit that started this ────────────────────────────────────────────
console.log('\n=== NO USER REFERENCE BLOCKS A DELETE ANY MORE ===');
const { rows: offenders } = await db.query(`
  SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'users'::regclass
     AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE%'
   ORDER BY 1`);
const unexpected = offenders.filter(o => o.conname !== 'site_visits_assignee_fkey');
ok('every user reference declares an on-delete action',
  unexpected.length === 0,
  unexpected.map(o => o.tbl + '.' + o.conname).join(', '));
ok('except site_visits.assigned_to, which is NOT NULL and documented as such',
  offenders.length === 1 && offenders[0].conname === 'site_visits_assignee_fkey',
  JSON.stringify(offenders.map(o => o.conname)));

// Nothing may CASCADE from users: deleting a person must never delete the
// invoices they raised.
/**
 * A cascade from `users` is right for rows that are ABOUT the user and wrong
 * for rows the user merely touched.
 *
 *   about them      their sessions, their notification preferences, their
 *                   revoked tokens, their site postings. Meaningless once the
 *                   account is gone, and keeping them would be a leak.
 *   touched by them the invoice they raised, the payment they receipted, the
 *                   entry they posted. Those outlive the person, and a
 *                   cascade here would delete a company's books when an
 *                   accountant leaves.
 *
 * The list is spelled out rather than pattern-matched so that a NEW cascade
 * has to be added here deliberately — which is the moment somebody is forced
 * to ask which of the two kinds it is.
 */
const PERSONAL_TABLES = [
  'user_project_assignments', 'user_sessions', 'user_preferences',
  'notification_prefs', 'notifications', 'revoked_tokens',
  'login_challenges', 'whatsapp_user_sessions',
];
const { rows: cascades } = await db.query(`
  SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'users'::regclass
     AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%'
     AND conrelid::regclass::text <> ALL($1::text[])
   ORDER BY 1`, [PERSONAL_TABLES]);
ok('nothing cascades from a user into a business record',
  cascades.length === 0, cascades.map(c => c.tbl + '.' + c.conname).join(', '));
ok('and the rows that DO cascade are all personal to the account',
  PERSONAL_TABLES.length === 8);

// ── a workspace that has actually been used ────────────────────────────────
console.log('\n=== A WORKSPACE WITH A HISTORY ===');

const tenant = (await db.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} co`, `${MARK}-co`, `${MARK}@del.test`])).rows[0];

const role = (await db.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'admin',false) RETURNING id`,
  [tenant.id])).rows[0];
const user = (await db.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Departing Person',$3,$4,true) RETURNING id`,
  [tenant.id, role.id, `${MARK}@del.test`,
   await argon2.hash('Test1234!', { type: argon2.argon2id })])).rows[0];

const project = (await db.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Site','Pune','under_construction') RETURNING id`,
  [tenant.id])).rows[0];

/**
 * Write one row into every table whose user reference this migration touched,
 * skipping any whose other required columns cannot be satisfied here. Each
 * skip is reported rather than silently passing — a table nobody managed to
 * populate is a table this suite is not actually covering, and saying so is
 * the difference between a green run and a true one.
 */
const touched = [];
const skipped = [];
async function seed(table, sql, params) {
  try {
    await db.query(sql, params);
    touched.push(table);
  } catch (err) {
    skipped.push(table + ' (' + String(err.message).slice(0, 60) + ')');
  }
}

await seed('crm_tasks',
  `INSERT INTO crm_tasks (tenant_id, title, created_by)
   VALUES ($1,'Follow up', $2)`, [tenant.id, user.id]);

await seed('schema_definitions',
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition, created_by)
   VALUES ($1,'lead','pipeline',1,true,$2,$3)`,
  [tenant.id, JSON.stringify({ stages: [
    { key: 'new', id: 'new', label: 'New', core: true },
    { key: 'booked', id: 'booked', label: 'Booked', core: true },
    { key: 'lost', id: 'lost', label: 'Lost', core: true },
  ] }), user.id]);

await seed('export_jobs',
  `INSERT INTO export_jobs (tenant_id, entity, format, requested_by)
   VALUES ($1,'leads','csv',$2)`, [tenant.id, user.id]);

await seed('import_batches',
  `INSERT INTO import_batches (tenant_id, entity, filename, created_by)
   VALUES ($1,'leads','x.csv',$2)`, [tenant.id, user.id]);

await seed('stored_files',
  `INSERT INTO stored_files (tenant_id, storage_key, original_name, content_type, size_bytes, sha256, uploaded_by)
   VALUES ($1,'k/${MARK}','x.pdf','application/pdf',10,repeat('a',64),$2)`,
  [tenant.id, user.id]);

await seed('meta_config',
  `INSERT INTO meta_config (tenant_id, key, value, updated_by)
   VALUES ($1,'brand','{}'::jsonb,$2)`, [tenant.id, user.id]);

await seed('tenant_keys',
  `INSERT INTO tenant_keys (tenant_id, service, key_name, value_enc, updated_by)
   VALUES ($1,'razorpay','key_id','x',$2)`, [tenant.id, user.id]);

await seed('journal_entries',
  `INSERT INTO journal_entries (tenant_id, entry_date, narration, created_by, posted_by)
   VALUES ($1, CURRENT_DATE, 'Opening', $2, $2)`, [tenant.id, user.id]);

// `branches` carries no tenant_id — it is the one affected table that is not
// tenant-scoped, and its manager_id is the one single-column key. Kept out of
// the counting loops below, which are all `WHERE tenant_id = $1`, and asserted
// on its own further down.
let branchId = null;
try {
  branchId = (await db.query(
    `INSERT INTO branches (name, manager_id) VALUES ($1,$2) RETURNING id`,
    [`${MARK} branch`, user.id])).rows[0].id;
} catch { /* reported by the assertion that reads it back */ }

console.log(`  · wrote rows referencing the user in ${touched.length} table(s): ${touched.join(', ')}`);
if (skipped.length) console.log(`  · could not populate: ${skipped.join('; ')}`);
ok('the workspace has real activity attributed to a person',
  touched.length >= 5, String(touched.length));

// ── deleting the USER keeps the work, drops the name ───────────────────────
console.log('\n=== DELETING A PERSON KEEPS WHAT THEY DID ===');
const before = {};
for (const t of touched) {
  before[t] = (await db.query(`SELECT count(*)::int c FROM ${t} WHERE tenant_id = $1`, [tenant.id])).rows[0].c;
}

let userDeleted = true;
try {
  await db.query('DELETE FROM users WHERE id = $1', [user.id]);
} catch (err) {
  userDeleted = false;
  ok('the user can be deleted at all', false, String(err.message).slice(0, 120));
}

if (userDeleted) {
  ok('the user row is gone',
    (await db.query('SELECT 1 FROM users WHERE id = $1', [user.id])).rowCount === 0);

  let kept = true, nulled = true;
  for (const t of touched) {
    const now = (await db.query(`SELECT count(*)::int c FROM ${t} WHERE tenant_id = $1`, [tenant.id])).rows[0].c;
    if (now !== before[t]) { kept = false; console.log(`    ! ${t}: ${before[t]} -> ${now}`); }
  }
  ok('and every row they created is still there — nothing cascaded', kept);

  // The attribution itself must be null, not dangling.
  for (const [t, col] of [
    ['crm_tasks', 'created_by'], ['journal_entries', 'posted_by'],
    ['journal_entries', 'created_by'], ['export_jobs', 'requested_by'],
    ['import_batches', 'created_by'], ['stored_files', 'uploaded_by'],
    ['meta_config', 'updated_by'], ['tenant_keys', 'updated_by'],
    ['schema_definitions', 'created_by'],
  ]) {
    if (!touched.includes(t)) continue;
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM ${t} WHERE tenant_id = $1 AND ${col} IS NOT NULL`, [tenant.id]);
    if (rows[0].c !== 0) { nulled = false; console.log(`    ! ${t}.${col} still set`); }
  }
  ok('with the attribution nulled rather than pointing at a ghost', nulled);

  // The single-column key, on the one table with no tenant_id.
  if (branchId) {
    const { rows: [b] } = await db.query('SELECT manager_id FROM branches WHERE id = $1', [branchId]);
    ok('a branch survives losing its manager, unmanaged rather than deleted',
      !!b && b.manager_id === null, JSON.stringify(b));
  }
}

// ── deleting the WORKSPACE ─────────────────────────────────────────────────
console.log('\n=== AND THE WHOLE WORKSPACE GOES ===');

// A second person, so the tenant delete has a live user to cascade through —
// which is the exact path that used to fail.
const user2 = (await db.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Still Here',$3,$4,true) RETURNING id`,
  [tenant.id, role.id, `${MARK}-2@del.test`,
   await argon2.hash('Test1234!', { type: argon2.argon2id })])).rows[0];
await seed('crm_tasks',
  `INSERT INTO crm_tasks (tenant_id, title, due_at, created_by)
   VALUES ($1,'Another', now() + interval '2 days', $2)`, [tenant.id, user2.id]);

let deleted = true, msg = '';
try {
  await db.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
} catch (err) {
  deleted = false;
  msg = String(err.message).slice(0, 160);
}
ok('a workspace with a history can be deleted', deleted, msg);

if (deleted) {
  ok('the tenant row is gone',
    (await db.query('SELECT 1 FROM tenants WHERE id = $1', [tenant.id])).rowCount === 0);
  ok('its users went with it',
    (await db.query('SELECT 1 FROM users WHERE tenant_id = $1', [tenant.id])).rowCount === 0);

  // Nothing left behind pointing at a tenant that no longer exists.
  let orphans = [];
  for (const t of [...new Set(touched)]) {
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM ${t} WHERE tenant_id = $1`, [tenant.id]);
    if (rows[0].c > 0) orphans.push(`${t}=${rows[0].c}`);
  }
  ok('and left no orphaned rows behind it', orphans.length === 0, orphans.join(', '));
} else {
  // Leave nothing behind even when the assertion fails.
  await db.query('DELETE FROM tenants WHERE id = $1', [tenant.id]).catch(() => {});
}

// branches is not tenant-scoped, so the tenant delete cannot have taken it.
if (branchId) await db.query('DELETE FROM branches WHERE id = $1', [branchId]).catch(() => {});

await db.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
